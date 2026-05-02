// src/components/sections/main
import { useNavigate } from 'react-router-dom';

const Main = ({curriculum}) => {
  console.log(curriculum);
  const sections = curriculum.sections;
  const navigate = useNavigate();
  return (
    <div 
      className="
        w-full h-[calc(100vh-var(--margin-header))]
        mt-header
      "
    >
      <div
        className="
          flex flex-col gap-4
          w-full h-full
          p-4
        "
      >
        <ul className="
          flex flex-col gap-4
        ">
          {sections.map((section, index) => (
          <li 
            key={section.id}
            className="
              flex flex-col
              border-2 border-b-[5px] border-main rounded-2xl
              
              overflow-hidden
            "
            onClick={() => {
              navigate(`/curriculum?curriculum_id=${curriculum.id}&section_id=${section.id}`);
            }}
          >
            <div className="
              flex flex-col justify-between flex-1
              w-full min-h-[157px] h-full
              p-5 pr-[60px]
              bg-[#202F36]
            ">
              <div className="
                w-full
                p-4
                rounded-2xl
                bg-body
              ">
                <h3 className="
                  text-white font-bold text-2xl
                  
                ">{section.title}</h3>
              </div>
            </div>
            
            <div className="
              flex flex-col justify-between flex-1 gap-2
              pt-3 px-5 pb-7
            ">
              <div className="">
                <h2 className="
                  text-white font-bold text-2xl
                ">섹션 {index + 1}</h2>
              </div>
              <div className="
                bg-main rounded-2xl
                w-full h-[18px]
              ">
              </div>

            </div>
          </li>
          ))}
        </ul>
      </div>

    </div>
  )
}
export default Main;